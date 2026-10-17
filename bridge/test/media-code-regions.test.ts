// CODE REGIONS IN A ROW'S TEXT (codex review 3, finding 3): a `MEDIA:` line inside Markdown
// code is a literal example, never a file. The detection is the upstream parser's
// (src/providers/openclaw/code-regions.ts, a port of src/shared/text/code-regions.ts at
// v2026.9.33). Each case below is a test of src/media/parse.test.ts at v2026.9.33 that
// bears on code regions, with its input and expected output. Atrium's split is called as
// the Control UI calls it (`extractAudioDirectives: false`, no Markdown image extraction —
// ui/src/lib/chat/message-normalizer.ts:399), so the `[[audio_as_voice]]` and Markdown
// image variants of the same cases do not apply.

import { describe, expect, it } from "vitest";

import { findCodeRegions } from "../src/providers/openclaw/code-regions.js";
import { rowBlocks, splitMediaFromOutput } from "../src/providers/openclaw/row-blocks.js";

/** parse.test.ts:10 `expectParsedMediaOutputCase`, on the segments Atrium reads. */
function expectParsedMediaOutputCase(input: string, expected: { text?: string; mediaUrls?: readonly string[] }) {
  const result = splitMediaFromOutput(input);
  expect(result.text).toBe(expected.text ?? "");
  const urls = (result.segments ?? []).flatMap((s) => (s.type === "media" ? [s.url] : []));
  expect(urls.length > 0 ? urls : undefined).toEqual(expected.mediaUrls);
}

describe("src/media/parse.test.ts (v2026.9.33) — code regions", () => {
  // :242
  it("extracts an indented paragraph continuation outside a code block", () => {
    expectParsedMediaOutputCase("Caption\n    MEDIA:https://example.com/a.png", {
      text: "Caption",
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  // :269
  it("returns ordered text and media segments while ignoring fenced MEDIA lines", () => {
    const result = splitMediaFromOutput(
      "Before\nMEDIA:https://example.com/a.png\n```text\nMEDIA:https://example.com/ignored.png\n```\nAfter",
    );
    expect(result.segments).toEqual([
      { type: "text", text: "Before" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "```text\nMEDIA:https://example.com/ignored.png\n```\nAfter" },
    ]);
  });

  // :308
  it.each(["    ", "\t"])("does not emit a whitespace-only media caption: %j", (whitespace) => {
    const result = splitMediaFromOutput(`${whitespace}\nMEDIA:https://example.com/a.png`);
    expect(result.text).toBe("");
    expect(result.segments).toEqual([{ type: "media", url: "https://example.com/a.png" }]);
  });

  // :322-366 — the three indented cases are the ones a fence-only detection missed.
  it.each([
    { name: "a marker carrying trailing text", separator: "\n", lines: ["```python", "value = 'a  b'", "``` not a close", "other = 'c  d'", "```"] },
    { name: "an unclosed fence", separator: "\n", lines: ["```python", "value = 'a  b'", "other = 'c  d'"] },
    { name: "an indented closing fence", separator: "\n", lines: ["```python", "value = 'a  b'", "   ```"] },
    { name: "a four-space indented block", separator: "\n\n", lines: ["    MEDIA:https://example.com/literal.png", "    literal = 'a  b'"] },
    { name: "an indented block inside a list", separator: "\n\n", lines: ["- Example", "", "      MEDIA:https://example.com/literal.png"] },
    { name: "a tab-indented block", separator: "\n\n", lines: ["\tMEDIA:https://example.com/literal.png", "\tliteral = 'a  b'"] },
  ])("preserves canonical code examples with $name", ({ lines, separator }) => {
    const code = lines.join("\n");
    expectParsedMediaOutputCase(`MEDIA:https://example.com/a.png${separator}${code}`, {
      text: code,
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  // :370-417, the `MEDIA:` directive case.
  it("preserves code indentation and paragraph breaks with a MEDIA directive", () => {
    const formattedMediaReply = [
      "Here is the code.",
      "",
      "```python",
      "def summarize(rows):",
      "    totals = {}",
      "    for row in rows:",
      "        totals[row] = 1",
      "    return totals",
      "```",
      "",
      "The attachment is ready.",
    ].join("\n");
    expectParsedMediaOutputCase(`${formattedMediaReply}\n\nMEDIA:https://example.com/config.png`, {
      text: formattedMediaReply,
      mediaUrls: ["https://example.com/config.png"],
    });
  });
});

describe("the row: an indented example is text, one file only (codex review 3, finding 3)", () => {
  it.each([
    ["four spaces", "MEDIA:https://example.com/a.png\n\n    MEDIA:https://example.com/literal.png"],
    ["a list item", "MEDIA:https://example.com/a.png\n\n- Example\n\n      MEDIA:https://example.com/literal.png"],
    ["a tab", "MEDIA:https://example.com/a.png\n\n\tMEDIA:https://example.com/literal.png"],
  ])("%s", (_name, content) => {
    const out = rowBlocks({ role: "assistant", content }, "agent:main:main").blocks;
    expect(out.filter((b) => b.type === "file")).toHaveLength(1);
    expect(out.find((b) => b.type === "text")).toMatchObject({ text: expect.stringContaining("MEDIA:https://example.com/literal.png") });
  });

  it("the parser's regions: block code (fenced, indented, nested) and inline spans apart", () => {
    expect(findCodeRegions("plain text")).toEqual([]);
    expect(findCodeRegions("a `b` c").map((r) => r.block)).toEqual([false]);
    expect(findCodeRegions("- item\n\n      code").map((r) => r.block)).toEqual([true]);
    expect(findCodeRegions("> ```\n> x\n> ```").map((r) => r.block)).toEqual([true]);
  });
});

// The IP policy, ported as is (src/providers/openclaw/net-policy-ip.ts): its verdict decides
// whether a remote `MEDIA:` line is a file or stays text.
describe("src/media/parse.test.ts (v2026.9.33) — remote media hosts", () => {
  // parse.test.ts:46 `expectRejectedRemoteMediaUrlCase`.
  const expectRejectedRemoteMediaUrlCase = (input: string) => expectParsedMediaOutputCase(input, { text: input });

  // :204
  it("does not absorb an unsafe remote URL into a spaced local media path", () => {
    expectParsedMediaOutputCase("MEDIA:C:\\Users\\First Last\\workspace\\shot.png https://127.0.0.1/secret.png", {
      mediaUrls: ["C:\\Users\\First Last\\workspace\\shot.png"],
      text: "https://127.0.0.1/secret.png",
    });
  });

  // :214
  it.each([
    "MEDIA:http://example.com/a.png",
    'MEDIA:"http://example.com/a.png)"',
    "MEDIA:https://intranet/a.png",
    "MEDIA:https://printer/a.png",
    "MEDIA:https://localhost/a.png",
    "MEDIA:https://localhost../a.png",
    "MEDIA:https://127.0.0.1/a.png",
    'MEDIA:"https://127.0.0.1/a.png)"',
    "MEDIA:https://127.0.0.1../a.png",
    "MEDIA:https://169.254.169.254/latest/meta-data",
    'MEDIA:"https://169.254.169.254/a.png)"',
    "MEDIA:https://[::1]/a.png",
    "MEDIA:https://metadata.google.internal/a.png",
    "MEDIA:https://metadata.google.internal../a.png",
    "MEDIA:https://example..com/a.png",
    "MEDIA:https://media.local/a.png",
  ])("rejects unsafe remote media URL: %s", (input) => {
    expectRejectedRemoteMediaUrlCase(input);
  });

  // parse-output.ts:136-138: a host without a dot is refused before any IP check — every
  // bare IPv6 literal, global unicast included (the reduced port accepted 2000::/3). And
  // the ranges are ipaddr.js 2.5.0's: 198.18.0.0/15 benchmarking, 100::/64 discard.
  it.each([
    "MEDIA:https://[2606:4700::1111]/a.png",
    "MEDIA:https://[100::1]/a.png",
    "MEDIA:https://198.19.1.1/a.png",
    "MEDIA:https://100.100.100.200/a.png",
    "MEDIA:https://0x7f.1/a.png",
  ])("the upstream policy, not a subset: %s stays text", (input) => {
    expectRejectedRemoteMediaUrlCase(input);
  });

  it("a public IPv4 literal is a remote file; its IPv4-mapped spelling is not (the URL parser writes it in hextets: no dot)", () => {
    expectParsedMediaOutputCase("MEDIA:https://93.184.216.34/a.png", { mediaUrls: ["https://93.184.216.34/a.png"] });
    expectRejectedRemoteMediaUrlCase("MEDIA:https://[::ffff:93.184.216.34]/a.png");
  });
});
