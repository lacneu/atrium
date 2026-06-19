// The transport split is MODEL-NATIVE (inline) vs TOOL-READ (reference) — these
// tests pin that it is NOT literally image-vs-non-image (mode gates reference) and
// that it discriminates correctly per mode.

import { describe, expect, test } from "vitest";
import { classifyAttachment, isModelNativeMime } from "./mediaTransport";

describe("isModelNativeMime", () => {
  test("images are model-native (Vision)", () => {
    expect(isModelNativeMime("image/png")).toBe(true);
    expect(isModelNativeMime("image/jpeg")).toBe(true);
    expect(isModelNativeMime("IMAGE/WEBP")).toBe(true); // case-insensitive
  });
  test("video / audio / docs are NOT model-native (tool-read)", () => {
    expect(isModelNativeMime("video/mp4")).toBe(false);
    expect(isModelNativeMime("audio/mpeg")).toBe(false);
    expect(isModelNativeMime("application/pdf")).toBe(false);
    expect(isModelNativeMime(null)).toBe(false);
    expect(isModelNativeMime(undefined)).toBe(false);
  });
});

describe("classifyAttachment", () => {
  test("inline mode → everything inline (no reference transport)", () => {
    expect(
      classifyAttachment({ mimeType: "video/mp4", inboundMediaMode: "inline" }),
    ).toBe("inline");
    expect(
      classifyAttachment({ mimeType: "image/png", inboundMediaMode: "inline" }),
    ).toBe("inline");
  });

  test("shared-fs mode → tool-read goes by REFERENCE, model-native stays inline", () => {
    expect(
      classifyAttachment({ mimeType: "video/mp4", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    expect(
      classifyAttachment({ mimeType: "audio/mpeg", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    expect(
      classifyAttachment({
        mimeType: "application/pdf",
        inboundMediaMode: "shared-fs",
      }),
    ).toBe("reference");
    // A Vision image MUST stay inline even in shared-fs (the model needs the bytes).
    expect(
      classifyAttachment({ mimeType: "image/png", inboundMediaMode: "shared-fs" }),
    ).toBe("inline");
  });

  test("the criterion is purpose, NOT image-vs-non-image: a tool-read file in inline mode is inline, an image in shared-fs is inline", () => {
    // same MIME, different mode → different transport (mode gates reference)
    expect(
      classifyAttachment({ mimeType: "application/pdf", inboundMediaMode: "inline" }),
    ).toBe("inline");
    expect(
      classifyAttachment({ mimeType: "application/pdf", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    // image never becomes a reference, regardless of mode
    expect(
      classifyAttachment({ mimeType: "image/gif", inboundMediaMode: "shared-fs" }),
    ).toBe("inline");
  });
});
