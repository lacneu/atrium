// Phase 3 — parsing the inbound `referenceAttachments` body field (defensive: a
// malformed entry is dropped, a non-array yields [], never throws) + that a /send
// body carries them distinctly from the inline `attachments` (two-axis, D-D).

import { describe, expect, it } from "vitest";
import {
  parseReferenceAttachments,
  parseSendBody,
} from "../src/server.js";

describe("parseReferenceAttachments", () => {
  it("parses valid entries, filling mime/fileName defaults", () => {
    expect(
      parseReferenceAttachments([
        { url: "https://c/u1", mimeType: "video/mp4", fileName: "v.mp4" },
        { url: "https://c/u2" }, // missing meta → defaults
      ]),
    ).toEqual([
      { url: "https://c/u1", mimeType: "video/mp4", fileName: "v.mp4" },
      { url: "https://c/u2", mimeType: "application/octet-stream", fileName: "file" },
    ]);
  });

  it("drops entries without a url; a non-array yields []", () => {
    expect(parseReferenceAttachments([{ mimeType: "x" }, { url: "" }])).toEqual([]);
    expect(parseReferenceAttachments(undefined)).toEqual([]);
    expect(parseReferenceAttachments("nope")).toEqual([]);
  });
});

describe("parseSendBody carries the two axes distinctly", () => {
  it("inline attachments AND reference attachments coexist", () => {
    const body = parseSendBody(
      JSON.stringify({
        chatId: "c1",
        text: "hello",
        clientMessageId: "m1",
        agentId: "main",
        canonical: "alice",
        instanceName: "primary",
        attachments: [{ content: "QQ==", mimeType: "image/png", fileName: "i.png" }],
        referenceAttachments: [
          { url: "https://c/u", mimeType: "video/mp4", fileName: "v.mp4" },
        ],
      }),
    );
    expect(body).not.toBeNull();
    expect(Array.isArray(body?.attachments)).toBe(true);
    expect(body?.referenceAttachments).toEqual([
      { url: "https://c/u", mimeType: "video/mp4", fileName: "v.mp4" },
    ]);
  });

  it("a body with no referenceAttachments yields [] (backward-compat)", () => {
    const body = parseSendBody(
      JSON.stringify({
        chatId: "c1",
        text: "hi",
        clientMessageId: "m1",
        agentId: "main",
        canonical: "alice",
        instanceName: "primary",
      }),
    );
    expect(body?.referenceAttachments).toEqual([]);
  });
});
